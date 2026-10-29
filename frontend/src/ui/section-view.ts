// The section controller: holds the line, fetches its answer once when it is first shown (D-26),
// draws it with its own camera in place of the plan (D-06, D-07), and picks from the answer's
// pieces on a click (D-25). The map view calls it from a few narrow hooks and hands it the plan's
// state through getters, so this module computes no limits or style of its own (D-10).

import { fetchSection, sectionKey, type SectionAnswer, type SectionResult } from '../data/section'
import { pickSection, pinchedLayers, type SectionHit } from '../data/section-pick'
import { classifyQuad, layersSetLine, sectionValues, type SectionValues } from '../data/section-values'
import { LatestWins } from '../data/latest-wins'
import type { ParIdentity } from '../data/parmap'
import type { ColormapName, ValueScale } from '../gl/colormap'
import { classLabel, type EffectiveStyle } from '../gl/field-style'
import type { MeshLayer } from '../gl/mesh-layer'
import { SectionCamera } from '../gl/section-camera'
import { SectionLayer } from '../gl/section-layer'
import type { SelectMode } from '../state/rules'
import { prefersReducedMotion } from './chrome'
import type { ReadoutPick } from './readout'
import { axesInset, renderSectionAxes } from './section-axes'
import { renderSectionControls, type SectionControlsHandle } from './section-controls'

/** What the plan draws now, read on every refresh. */
export interface SectionPlanState {
  fullField: Float32Array | null
  limits: [number, number]
  style: EffectiveStyle
  /** The scale the drawn field is in, for the class line. */
  scale: ValueScale
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

export type SectionReadoutPick = Extract<ReadoutPick, { kind: 'section' }>

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
  /** What the last click names, read again from the plan's current state; null when it hit nothing. */
  readoutPick(): SectionReadoutPick | null
  /** The class the picked value is drawn in, or null while continuous or with no value. */
  readoutClassLine(): string | null
  /** Rings every layer of each selected cell's pieces (D-22, D-33). */
  selectionChanged(cells: ReadonlySet<number>): void
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

function pinchedLine(layers: number[]): string | null {
  if (layers.length === 0) return null
  const which = layers.length === 1 ? `layer ${layers[0]}` : `layers ${layers.join(', ')}`
  return `pinched out in this cell: ${which} (zero thickness)`
}

const OBS_LINE = 'the section colours parameter fields only'
const DOTS_LINE = 'this group is drawn as dots; the section shows no values for it'
const NO_IDOMAIN_NOTE = 'the grid file records no idomain'

// "1 section cell holds ... is" against "2 section cells hold ... are".
function cells(count: number): string {
  return count === 1 ? '1 section cell' : `${count} section cells`
}

function countLines(out: SectionValues): string[] {
  const one = (count: number, singular: string, plural: string) =>
    `${cells(count)} ${count === 1 ? singular : plural}`
  const lines: string[] = []
  if (out.contested > 0) lines.push(one(out.contested, 'is contested; no value drawn', 'are contested; no value drawn'))
  if (out.beyondLimits > 0) lines.push(`${cells(out.beyondLimits)} beyond the limits`)
  if (out.inactiveWithValue > 0) {
    lines.push(
      one(
        out.inactiveWithValue,
        'holds a value but is inactive in idomain; drawn as absence',
        'hold a value but are inactive in idomain; drawn as absence',
      ),
    )
  }
  if (out.absentWithValue > 0) {
    lines.push(
      one(
        out.absentWithValue,
        'holds a value but has no usable thickness or lies outside the model; drawn as absence',
        'hold a value but have no usable thickness or lie outside the model; drawn as absence',
      ),
    )
  }
  return lines
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
  // A failure that asking again may cure: said, but the next "Section view" click retries.
  let failure: string | null = null
  let picked: SectionHit | null = null
  // The selected cells, kept so a section built later rings them too.
  let selected: ReadonlySet<number> = new Set()
  let ringedKey = ''
  // The plan's layer, outlined across the section by the frame (D-19).
  let planLayer = 0
  // What the last paint drew, so the legend describes the colours on screen.
  let painted: { out: SectionValues; plan: SectionPlanState } | null = null

  const frame = renderSectionAxes({ area: opts.area })

  // The fit keeps clear of the axes, read at each fit since the pixel ratio can change.
  function fitInset(): void {
    camera.setInset(axesInset(window.devicePixelRatio || 1))
  }

  // Reads only the camera and the held answer, never the plan layer's own GL state.
  function paintFrame(): void {
    if (!isShown || answer === null) return
    frame.paint({ camera, answer, planLayer, width: opts.canvas.width, height: opts.canvas.height })
  }

  const controls = renderSectionControls(opts.controlsHost, {
    onPlan: () => show(false),
    onSection: () => show(true),
    // A purely visual choice: kept for the page's life, never written to the view state (D-04).
    onVe: (mode) => {
      fitInset()
      camera.setVe(mode)
      if (isShown) {
        opts.requestRedraw()
        opts.repaintLegend()
      }
    },
  })

  function dropAnswer(): void {
    slot.cancel()
    fetching = null
    answer = null
    sectionLayer?.dispose()
    sectionLayer = null
    fitted = false
    picked = null
    painted = null
    ringedKey = ''
  }

  function setLine(a: [number, number], b: [number, number]): void {
    dropAnswer()
    line = { a, b }
    refusal = null
    failure = null
    controls.setLoading(false)
    controls.setRefusal(null)
    controls.setFailure(null)
    controls.setHasLine(true)
    if (isShown || wanted) request()
  }

  function refuse(reason: string): void {
    refusal = reason
    wanted = false
    controls.setRefusal(reason)
    if (isShown) hide()
  }

  function fail(reason: string): void {
    failure = reason
    wanted = false
    controls.setFailure(reason)
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
          if (value.retryable) fail(value.reason)
          else refuse(value.reason)
          return
        }
        answer = value.answer
        if (wanted) display()
      },
      (error: unknown) => {
        fetching = null
        controls.setLoading(false)
        fail(`the section could not be read: ${describeError(error)}`)
      },
    )
  }

  // Builds the layer once per answer and fits once per line; showing it again reuses both.
  function display(): void {
    if (answer === null) return
    if (sectionLayer === null) {
      const gl = opts.gl()
      if (gl === null) {
        fail('the graphics context is not ready')
        return
      }
      try {
        sectionLayer = new SectionLayer(gl, answer)
      } catch (error) {
        fail(`the section could not be drawn: ${describeError(error)}`)
        return
      }
      opts.paintColours(sectionLayer.layer)
      paint()
      ring()
    }
    if (!fitted) {
      fitInset()
      camera.fit(fitBounds(answer))
      fitted = true
    }
    isShown = true
    frame.setVisible(true)
    controls.setShown(true)
    opts.onShownChange(true)
    opts.requestRedraw()
    opts.repaintLegend()
  }

  function hide(): void {
    isShown = false
    frame.setVisible(false)
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
    if (failure !== null) {
      failure = null
      controls.setFailure(null)
    }
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

  // The plan's own colormap, limits and style object, as given, with values read only for the
  // quads in the answer (D-08, D-10, D-27). Absence keeps the hairline, no value the footprint (D-36).
  function paint(): void {
    if (sectionLayer === null || answer === null) return
    const plan = opts.plan()
    const out = sectionValues(answer, plan)
    const target = sectionLayer.layer
    target.setColormap(plan.colormap, plan.reverse)
    target.setLimits(plan.limits)
    target.setStyle(plan.style)
    target.setContested(out.contestedMask)
    target.setValues(out.values)
    target.setFootprint(out.noValue)
    target.setInactive(out.absence)
    painted = { out, plan }
  }

  // Recolours from the held answer and the plan's held field; never a new request (D-26).
  function refresh(): void {
    if (sectionLayer === null) return
    paint()
    if (isShown) {
      opts.repaintLegend()
      opts.requestRedraw()
    }
  }

  function units(): string {
    return answer?.lengthUnits ?? 'model units'
  }

  function click(x: number, y: number, mode: SelectMode): void {
    if (answer === null) return
    const [s, z] = camera.screenToWorld(x, y)
    const hit = pickSection(answer, s, z)
    // A shift or alt click on empty space changes nothing, the readout included (D-24).
    if (hit === null && mode !== 'replace') return
    picked = hit
    opts.onPick(hit, mode)
  }

  function readoutPick(): SectionReadoutPick | null {
    if (picked === null || answer === null) return null
    const hit = picked
    const plan = opts.plan()
    const u = units()
    const lines = [`distance from A: ${formatNumber(hit.s)} ${u}`, `top ${formatNumber(hit.top)}, bottom ${formatNumber(hit.bottom)} ${u}`]
    const pinched = pinchedLine(pinchedLayers(answer, hit.piece))
    if (pinched !== null) lines.push(pinched)
    return {
      kind: 'section',
      cellId: hit.cell,
      layer: hit.layer,
      selectionLabel: plan.selectionLabel,
      classification: classifyQuad(answer, plan, hit.piece * answer.nlay + hit.layer),
      absence: hit.status === 0 ? null : (answer.statusText.get(hit.status) ?? `status ${hit.status}`),
      lines,
    }
  }

  // The class lives in the drawn scale, so it is read from the plan's scaled field.
  function readoutClassLine(): string | null {
    const pick = readoutPick()
    if (pick === null || pick.absence !== null || pick.classification === null) return null
    const plan = opts.plan()
    if (plan.obsActive || plan.fullField === null) return null
    const c = pick.classification
    const index = c.kind === 'valued' ? c.row : c.kind === 'interpolated' ? pick.cellId : null
    if (index === null) return null
    return classLabel(plan.fullField[index] ?? Number.NaN, plan.limits, plan.style, plan.scale)
  }

  // Every layer of every piece on a selected cell: the whole column (D-33).
  function ring(): boolean {
    if (sectionLayer === null || answer === null) return false
    const ids: number[] = []
    for (let p = 0; p < answer.nPieces; p++) {
      if (!selected.has(answer.cell[p])) continue
      for (let k = 0; k < answer.nlay; k++) ids.push(p * answer.nlay + k)
    }
    const key = ids.join(',')
    if (key === ringedKey) return false
    ringedKey = key
    sectionLayer.layer.setSelectedCells(ids)
    return true
  }

  function selectionChanged(cells: ReadonlySet<number>): void {
    selected = new Set(cells)
    if (ring() && isShown) opts.requestRedraw()
  }

  function legendLines(): string[] {
    if (answer === null || !fitted) return []
    const lines = [camera.veText()]
    if (painted !== null) {
      const { out, plan } = painted
      if (plan.obsActive) lines.push(OBS_LINE)
      else if (plan.drawsAsPoints) lines.push(DOTS_LINE)
      else if (plan.drawnGroup !== null) {
        const layers = layersSetLine(plan.drawnGroup, out.layersSet, answer.nlay)
        if (layers !== null) lines.push(layers)
      }
      lines.push(...countLines(out))
      if (!plan.hasIdomain) lines.push(...plan.meshNotes.filter((note) => note.startsWith(NO_IDOMAIN_NOTE)))
    }
    lines.push(...answer.notes)
    return lines
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
      paintFrame()
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
      fitted = true
      fitInset()
      let stated = camera.veText()
      // Eases like the plan's fit, and jumps when reduced motion is asked for (D-21).
      camera.fitAnimated(
        fitBounds(answer),
        () => {
          if (!isShown) return
          opts.requestRedraw()
          const text = camera.veText()
          if (text !== stated) {
            stated = text
            opts.repaintLegend()
          }
        },
        { reduced: prefersReducedMotion() },
      )
    },
    resize(width, height) {
      camera.resize(width, height)
    },
    click,
    readoutPick,
    readoutClassLine,
    selectionChanged,
    refresh,
    // Moves the band only; the section's colours do not depend on the plan's layer.
    planLayerChanged(layer) {
      planLayer = layer
      paintFrame()
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
      frame.dispose()
      controls.dispose()
    },
  }
}
