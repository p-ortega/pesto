// The section controller: holds the line, fetches its answer once when it is first shown (D-26),
// draws it with its own camera in place of the plan (D-06, D-07), and picks from the answer's
// pieces on a click (D-25). The map view calls it from a few narrow hooks and hands it the plan's
// state through getters, so this module computes no limits or style of its own.

import { fetchSection, sectionKey, type SectionAnswer, type SectionResult } from '../data/section'
import { pickSection, type SectionHit } from '../data/section-pick'
import { LatestWins } from '../data/latest-wins'
import type { ParIdentity } from '../data/parmap'
import type { ColormapName } from '../gl/colormap'
import type { EffectiveStyle } from '../gl/field-style'
import type { MeshLayer } from '../gl/mesh-layer'
import { SectionCamera, formatVe } from '../gl/section-camera'
import { SectionLayer } from '../gl/section-layer'
import type { SelectMode } from '../state/rules'
import { renderSectionControls, type SectionControlsHandle } from './section-controls'

/** What the plan draws now, read on every refresh. */
export interface SectionPlanState {
  fullField: Float32Array | null
  limits: [number, number]
  style: EffectiveStyle
  colormap: ColormapName
  reverse: boolean
  fieldKind: 'block' | 'cell'
  drawnGroup: string | null
  /** The drawn pilot-point group's layer, or null. */
  ppLayer: number | null
  joined: Array<ParIdentity | null>
  cellArray: Int32Array
  layerArray: Int32Array
  nCells: number
  drawsAsPoints: boolean
  obsActive: boolean
  hasIdomain: boolean
  meshNotes: string[]
  /** The active mask the plan uses when the grid has no idomain, else null. */
  referenced: Uint8Array | null
  selectionLabel: string
}

export interface SectionViewOptions {
  area: HTMLElement
  canvas: HTMLCanvasElement
  controlsHost: HTMLElement
  runId: string | null
  gl(): WebGL2RenderingContext | null
  plan(): SectionPlanState
  /** Applies the theme colours to a layer, the same way the plan layer gets them. */
  paintColours(layer: MeshLayer): void
  onShownChange(shown: boolean): void
  onPick(hit: SectionHit | null, mode: SelectMode): void
  requestRedraw(): void
  repaintLegend(): void
}

export interface SectionReadout {
  hit: SectionHit
  selectionLabel: string
  /** The server's status text when the clicked quad is absence, else null. */
  absence: string | null
  lines: string[]
}

export interface SectionViewHandle {
  shown(): boolean
  hasLine(): boolean
  /** Both ends in world coordinates, mesh origin included. */
  setLine(a: [number, number], b: [number, number]): void
  show(on: boolean): void
  draw(): void
  pan(dx: number, dy: number): void
  zoomAt(x: number, y: number, factor: number): void
  fit(): void
  resize(width: number, height: number): void
  click(x: number, y: number, mode: SelectMode): void
  readoutPick(): SectionReadout | null
  paintReadout(el: HTMLElement): void
  refresh(): void
  planLayerChanged(layer: number): void
  reupload(): void
  meshLayer(): MeshLayer | null
  legendLines(): string[]
  appendLegendLines(el: HTMLElement): void
  paintLegendOnly(el: HTMLElement): void
  controls(): SectionControlsHandle
  dispose(): void
}

function formatNumber(value: number): string {
  return String(Number(value.toPrecision(6)))
}

function appendLine(el: HTMLElement, text: string, ...classes: string[]): HTMLElement {
  const line = document.createElement('div')
  line.classList.add(...classes)
  line.textContent = text
  el.appendChild(line)
  return line
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function createSectionView(opts: SectionViewOptions): SectionViewHandle {
  const camera = new SectionCamera(opts.canvas.width, opts.canvas.height)
  const slot = new LatestWins<SectionResult>()
  let line: { a: [number, number]; b: [number, number] } | null = null
  let answer: SectionAnswer | null = null
  let sectionLayer: SectionLayer | null = null
  let isShown = false
  // The user asked for the section and has not gone back since; an answer landing then is shown.
  let wanted = false
  let fetching: string | null = null
  let fitted = false
  let refusal: string | null = null
  let picked: SectionReadout | null = null
  // Kept for the layer band a later plan draws (D-19).
  let planLayer = 0

  const controls = renderSectionControls(opts.controlsHost, {
    onPlan: () => show(false),
    onSection: () => show(true),
  })

  function dropAnswer(): void {
    slot.cancel()
    fetching = null
    answer = null
    sectionLayer?.dispose()
    sectionLayer = null
    fitted = false
    picked = null
  }

  function setLine(a: [number, number], b: [number, number]): void {
    dropAnswer()
    line = { a, b }
    refusal = null
    controls.setLoading(false)
    controls.setRefusal(null)
    controls.setHasLine(true)
    if (isShown || wanted) request()
  }

  function refuse(reason: string): void {
    refusal = reason
    wanted = false
    controls.setRefusal(reason)
    if (isShown) hide()
  }

  function request(): void {
    if (line === null) return
    const { a, b } = line
    const key = sectionKey(opts.runId, a, b)
    if (fetching === key) return
    fetching = key
    controls.setLoading(true)
    void slot.run(key, (signal) => fetchSection(a, b, { signal })).then(
      (result) => {
        if (result.stale) return
        fetching = null
        controls.setLoading(false)
        const value = result.value
        if (!value.ok) {
          refuse(value.reason)
          return
        }
        answer = value.answer
        if (wanted) display()
      },
      (error: unknown) => {
        fetching = null
        controls.setLoading(false)
        refuse(`the section could not be read: ${describeError(error)}`)
      },
    )
  }

  // Builds the layer once per answer and fits once per line; showing it again reuses both.
  function display(): void {
    if (answer === null) return
    if (sectionLayer === null) {
      const gl = opts.gl()
      if (gl === null) {
        refuse('the graphics context is not ready')
        return
      }
      sectionLayer = new SectionLayer(gl, answer)
      opts.paintColours(sectionLayer.layer)
      paintGeometry()
    }
    if (!fitted) {
      camera.fit(fitBounds(answer))
      fitted = true
    }
    isShown = true
    controls.setShown(true)
    opts.onShownChange(true)
    opts.requestRedraw()
    opts.repaintLegend()
  }

  function hide(): void {
    isShown = false
    controls.setShown(false)
    opts.onShownChange(false)
    opts.requestRedraw()
    opts.repaintLegend()
  }

  function show(on: boolean): void {
    if (!on) {
      wanted = false
      if (isShown) hide()
      return
    }
    if (line === null || refusal !== null) return
    wanted = true
    if (answer !== null) display()
    else request()
  }

  // The whole line from A (0) to B, so an end outside the mesh reads as empty distance (D-40).
  function fitBounds(held: SectionAnswer): [number, number, number, number] {
    let zMin = Number.POSITIVE_INFINITY
    let zMax = Number.NEGATIVE_INFINITY
    for (let i = 0; i < held.z.length; i++) {
      const v = held.z[i]
      if (!Number.isFinite(v)) continue
      if (v < zMin) zMin = v
      if (v > zMax) zMax = v
    }
    if (!(zMin <= zMax)) {
      zMin = 0
      zMax = 1
    }
    return [0, held.line.length, zMin, zMax]
  }

  // Geometry only: active quads in the quiet footprint fill, absence as the hairline outline (D-16, D-36).
  function paintGeometry(): void {
    if (sectionLayer === null || answer === null) return
    const { status } = answer
    const n = status.length
    const footprint = new Uint8Array(n)
    const inactive = new Uint8Array(n)
    for (let q = 0; q < n; q++) {
      footprint[q] = status[q] === 0 ? 1 : 0
      inactive[q] = status[q] === 0 ? 0 : 1
    }
    const target = sectionLayer.layer
    target.setValues(new Float32Array(n).fill(Number.NaN))
    target.setFootprint(footprint)
    target.setInactive(inactive)
  }

  function refresh(): void {
    if (sectionLayer === null) return
    paintGeometry()
    if (isShown) opts.requestRedraw()
  }

  function units(): string {
    return answer?.lengthUnits ?? 'model units'
  }

  function click(x: number, y: number, mode: SelectMode): void {
    if (answer === null) return
    const [s, z] = camera.screenToWorld(x, y)
    const hit = pickSection(answer, s, z)
    if (hit === null) {
      picked = null
    } else {
      const u = units()
      picked = {
        hit,
        selectionLabel: opts.plan().selectionLabel,
        absence: hit.status === 0 ? null : (answer.statusText.get(hit.status) ?? `status ${hit.status}`),
        lines: [`distance from A: ${formatNumber(hit.s)} ${u}`, `top ${formatNumber(hit.top)}, bottom ${formatNumber(hit.bottom)} ${u}`],
      }
    }
    opts.onPick(hit, mode)
  }

  function paintReadout(el: HTMLElement): void {
    el.textContent = ''
    el.classList.add('floating')
    if (picked === null) {
      appendLine(el, 'Click a cell to see its value.', 'label').style.color = 'var(--ink-muted)'
      return
    }
    if (picked.absence !== null) appendLine(el, picked.absence, 'body')
    appendLine(el, `layer ${picked.hit.layer}, cell ${picked.hit.cell} · ${picked.selectionLabel}`, 'label')
    for (const text of picked.lines) appendLine(el, text, 'label', 'tabular-nums')
  }

  function legendLines(): string[] {
    if (answer === null || !fitted) return []
    return [`vertical exaggeration ${formatVe(camera.ve())}× (fitted)`]
  }

  function appendLegendLines(el: HTMLElement): void {
    const lines = legendLines()
    if (lines.length === 0) return
    el.classList.add('floating')
    for (const text of lines) appendLine(el, text, 'label', 'section-legend-line')
  }

  return {
    shown: () => isShown,
    hasLine: () => line !== null,
    setLine,
    show,
    draw() {
      if (!isShown || sectionLayer === null) return
      sectionLayer.setCamera(camera)
      sectionLayer.draw()
    },
    pan(dx, dy) {
      camera.pan(dx, dy)
      if (isShown) opts.requestRedraw()
    },
    zoomAt(x, y, factor) {
      camera.zoomAt(x, y, factor)
      if (isShown) opts.requestRedraw()
    },
    fit() {
      if (answer === null) return
      camera.fit(fitBounds(answer))
      fitted = true
      if (isShown) {
        opts.requestRedraw()
        opts.repaintLegend()
      }
    },
    resize(width, height) {
      camera.resize(width, height)
    },
    click,
    readoutPick: () => picked,
    paintReadout,
    refresh,
    planLayerChanged(layer) {
      planLayer = layer
    },
    reupload() {
      sectionLayer?.reupload()
    },
    meshLayer: () => sectionLayer?.layer ?? null,
    legendLines,
    appendLegendLines,
    paintLegendOnly(el) {
      el.textContent = ''
      appendLegendLines(el)
    },
    controls: () => controls,
    dispose() {
      dropAnswer()
      controls.dispose()
    },
  }
}
