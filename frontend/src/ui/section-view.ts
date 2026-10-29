// The section controller: holds the line, fetches its answer once when it is first shown (D-26),
// draws it with its own camera in place of the plan (D-06, D-07), and picks from the answer's
// pieces on a click (D-25). The map view calls it from a few narrow hooks and hands it the plan's
// state through getters, so this module computes no limits or style of its own (D-10).

import { fetchSection, sectionKey, type SectionAnswer, type SectionResult } from '../data/section'
import { pickSection, pinchedLayers, type SectionHit } from '../data/section-pick'
import { classifyQuad, layersSetLine, sectionValues, type LayerFill, type SectionValues } from '../data/section-values'
import {
  contestedLine,
  planSiblings,
  SiblingFields,
  siblingKey,
  stackLegend,
  type LegendEntry,
  type SiblingFieldRequest,
  type SiblingPlan,
  type StackStatus,
} from '../data/section-siblings'
import type { PpIndex } from '../data/fields'
import { layerListWords, layerWords } from '../data/layer-words'
import { LatestWins } from '../data/latest-wins'
import type { ParIdentity } from '../data/parmap'
import { isPointGroup } from '../data/points'
import { applyScale, type ColormapName, type ValueScale } from '../gl/colormap'
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
  /** The pilot-point index, which gives each interpolated sibling its layer. */
  ppIndex: PpIndex
  /** Every parameter's identity, from which the sibling groups are found. */
  identities: readonly ParIdentity[]
  pointXy: Float32Array | null
  /** The iteration, statistic and realization of the field the plan holds; siblings are read with the same. */
  heldChoice: { iteration: number; stat: string; realization: string | null } | null
}

export interface SectionViewOptions {
  area: HTMLElement
  canvas: HTMLCanvasElement
  controlsHost: HTMLElement
  runId: string | null
  gl(): WebGL2RenderingContext | null
  plan(): SectionPlanState
  /** Reads one sibling group's field the way the plan reads its own. */
  loadField(request: SiblingFieldRequest, signal: AbortSignal): Promise<Float32Array>
  /** Applies the theme colours to a layer, the same way the plan layer gets them. */
  paintColours(layer: MeshLayer): void
  onShownChange(shown: boolean): void
  onPick(hit: SectionHit | null, mode: SelectMode): void
  requestRedraw(): void
  repaintLegend(): void
  /** A sibling field landed or failed, so a readout on its layer may now say more. */
  refreshReadout(): void
  /** The width the map's left cards cover, in CSS px, read only when the section fits (LD-4). */
  leftBand?: () => number
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
  /**
   * The sibling group the last click's layer is filled by, when that is not the plan's group, and
   * its unscaled field; a null field means the plan's own block field holds it.
   */
  readoutSource(): { group: string; field: Float32Array | null } | null
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
  const which = layers.length === 1 ? layerWords(layers[0]) : layerListWords(layers)
  return `pinched out in this cell (zero thickness): ${which}`
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
  if (out.unknownCell > 0) {
    lines.push(one(out.unknownCell, 'names a cell the plan does not hold; drawn as absence', 'name a cell the plan does not hold; drawn as absence'))
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

function noLogLine(count: number): string | null {
  if (count === 0) return null
  const verb = count === 1 ? 'holds a sibling value' : 'hold sibling values'
  return `${cells(count)} ${verb} of zero or less, which log10 cannot draw; drawn with no value`
}

interface Stack {
  siblings: SiblingPlan
  fills: LayerFill[]
  status: StackStatus
  requests: SiblingFieldRequest[]
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
  let painted: { out: SectionValues; plan: SectionPlanState; stack: Stack | null } | null = null
  const siblingFields = new SiblingFields(opts.loadField, () => {
    refresh()
    if (picked !== null) opts.refreshReadout()
  })
  let siblingMemo: { inputs: unknown[]; plan: SiblingPlan | null } | null = null
  const scaledMemo = new WeakMap<Float32Array, { scale: ValueScale; scaled: Float32Array }>()

  const frame = renderSectionAxes({ area: opts.area })

  // The left band the last fit kept clear; the axis stays there until the next fit, so a fold never moves it.
  let fittedBand = 0

  // The fit keeps clear of the axes and the left cards, read at each fit since the pixel ratio can change.
  function fitInset(measure = true): void {
    if (measure) fittedBand = opts.leftBand?.() ?? 0
    camera.setInset(axesInset(window.devicePixelRatio || 1, fittedBand))
  }

  // Reads only the camera and the held answer, never the plan layer's own GL state.
  function paintFrame(): void {
    if (!isShown || answer === null) return
    frame.paint({ camera, answer, planLayer, width: opts.canvas.width, height: opts.canvas.height, bandCss: fittedBand })
  }

  const controls = renderSectionControls(opts.controlsHost, {
    onPlan: () => show(false),
    onSection: () => show(true),
    // A purely visual choice: kept for the page's life, never written to the view state (D-04).
    onVe: (mode) => {
      // An exaggeration change keeps the band the axis is drawn at; only a fit measures it again.
      fitInset(false)
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
      ring()
    }
    if (!fitted) {
      fitInset()
      camera.fit(fitBounds(answer))
      fitted = true
    }
    isShown = true
    paint()
    frame.setVisible(true)
    controls.setShown(true)
    opts.onShownChange(true)
    opts.requestRedraw()
    opts.repaintLegend()
  }

  function hide(): void {
    isShown = false
    // Siblings are read only while the section shows; what has not landed is asked for again next time.
    siblingFields.stop()
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

  function siblingPlanFor(plan: SectionPlanState, nlay: number): SiblingPlan | null {
    const inputs = [plan.drawnGroup, plan.joined, plan.cellArray, plan.layerArray, plan.ppIndex, plan.identities, plan.pointXy, nlay]
    if (siblingMemo !== null && siblingMemo.inputs.every((v, i) => v === inputs[i])) return siblingMemo.plan
    const groups = new Set<string>()
    for (const identity of plan.identities) groups.add(identity.pargp)
    for (const entry of plan.ppIndex.groups) groups.add(entry.group)
    const interpolated = new Set(plan.ppIndex.groups.map((g) => g.group))
    const found =
      plan.drawnGroup === null
        ? null
        : planSiblings(plan.drawnGroup, {
            groups: Array.from(groups),
            ppIndex: plan.ppIndex,
            joined: plan.joined,
            cellArray: plan.cellArray,
            layerArray: plan.layerArray,
            nlay,
            isPointGroup: (g) => !interpolated.has(g) && isPointGroup(plan.joined, plan.pointXy, g),
          })
    siblingMemo = { inputs, plan: found }
    return found
  }

  function scaled(raw: Float32Array, scale: ValueScale): Float32Array {
    const held = scaledMemo.get(raw)
    if (held !== undefined && held.scale === scale) return held.scaled
    const out = applyScale(raw, scale)
    scaledMemo.set(raw, { scale, scaled: out })
    return out
  }

  // The layer-by-layer fill when the drawn group has siblings; reads only fields already held.
  function stackFor(plan: SectionPlanState): Stack | null {
    if (answer === null || plan.obsActive || plan.drawsAsPoints || plan.fullField === null || plan.heldChoice === null) return null
    const siblings = siblingPlanFor(plan, answer.nlay)
    if (siblings === null) return null
    const field = plan.fullField
    const choice = plan.heldChoice
    const members = new Map(siblings.members.map((m) => [m.group, m]))
    const requests: SiblingFieldRequest[] = []
    const loading: number[] = []
    const failed = new Map<string, { group: string; layers: number[]; reason: string }>()
    const fills = siblings.fillers.map((groups, k): LayerFill => {
      if (groups.length === 0) return { kind: 'none' }
      if (groups.length > 1) return { kind: 'contested', groups }
      const member = members.get(groups[0])!
      if (member.group === plan.drawnGroup) return { kind: plan.fieldKind, group: member.group, field, raw: null }
      // A block field holds every group, so the plan's own one already answers a block sibling.
      if (member.kind === 'block' && plan.fieldKind === 'block') return { kind: 'block', group: member.group, field, raw: null }
      const request: SiblingFieldRequest = { kind: member.kind, group: member.group, ...choice }
      requests.push(request)
      const state = siblingFields.get(request)
      if (state === undefined || state.state === 'loading') {
        loading.push(k)
        return { kind: 'loading', group: member.group }
      }
      if (state.state === 'failed') {
        const held = failed.get(member.group) ?? { group: member.group, layers: [], reason: state.reason }
        held.layers.push(k)
        failed.set(member.group, held)
        return { kind: 'failed', group: member.group }
      }
      return { kind: member.kind, group: member.group, field: scaled(state.raw, plan.scale), raw: state.raw }
    })
    return { siblings, fills, status: { loading, failed: Array.from(failed.values()) }, requests }
  }

  // The plan's own colormap, limits and style object, as given, with values read only for the
  // quads in the answer (D-08, D-10, D-27). Absence keeps the hairline, no value the footprint (D-36).
  function paint(): void {
    if (sectionLayer === null || answer === null) return
    const plan = opts.plan()
    const stack = stackFor(plan)
    if (isShown) siblingFields.want(stack?.requests ?? [])
    const out = sectionValues(answer, plan, stack?.fills ?? null)
    const target = sectionLayer.layer
    target.setColormap(plan.colormap, plan.reverse)
    target.setLimits(plan.limits)
    target.setStyle(plan.style)
    target.setContested(out.contestedMask)
    target.setValues(out.values)
    target.setFootprint(out.noValue)
    target.setInactive(out.absence)
    painted = { out, plan, stack }
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
    // The frame paints over the left band and the axis strips, so a cell panned under them is not seen and not picked.
    const inset = axesInset(window.devicePixelRatio || 1, fittedBand)
    if (x < inset.left || y > opts.canvas.height - inset.bottom) return
    const [s, z] = camera.screenToWorld(x, y)
    const hit = pickSection(answer, s, z)
    // A shift or alt click on empty space changes nothing, the readout included (D-24).
    if (hit === null && mode !== 'replace') return
    // An alt click that takes a cell away clears the readout, as on the plan; absence is still named.
    picked = mode === 'remove' && hit !== null && hit.status === 0 ? null : hit
    opts.onPick(hit, mode)
  }

  // A cell the plan does not hold is named as unreadable before any status, since nothing about it can be read.
  function absenceReason(hit: SectionHit, nCells: number): string | null {
    if (hit.cell < 0 || hit.cell >= nCells) return `the plan holds no cell ${hit.cell}, so this section cell cannot be read`
    if (hit.status === 0 || answer === null) return null
    return answer.statusText.get(hit.status) ?? `status ${hit.status}`
  }

  // What fills the clicked layer when the section is stacked, else null.
  function pickedFill(plan: SectionPlanState): { stack: Stack; fill: LayerFill } | null {
    if (picked === null) return null
    const stack = stackFor(plan)
    const fill = stack?.fills[picked.layer]
    return stack === null || fill === undefined ? null : { stack, fill }
  }

  function fillLine(stack: Stack, fill: LayerFill, layer: number): string | null {
    if (fill.kind === 'contested') return contestedLine(layer, fill.groups)
    if (fill.kind === 'loading') return `${fill.group} is still being read for ${layerWords(layer)}`
    if (fill.kind === 'failed') return `${fill.group} could not be read, so ${layerWords(layer)} has no value`
    if (fill.kind === 'none') return `no group of ${stack.siblings.key} fills ${layerWords(layer)}`
    return null
  }

  function readoutPick(): SectionReadoutPick | null {
    if (picked === null || answer === null) return null
    const hit = picked
    const plan = opts.plan()
    const u = units()
    const lines = [`distance from A: ${formatNumber(hit.s)} ${u}`, `top ${formatNumber(hit.top)}, bottom ${formatNumber(hit.bottom)} ${u}`]
    const pinched = pinchedLine(pinchedLayers(answer, hit.piece))
    if (pinched !== null) lines.push(pinched)
    const absence = absenceReason(hit, plan.nCells)
    const stacked = pickedFill(plan)
    if (stacked !== null && absence === null) {
      const said = fillLine(stacked.stack, stacked.fill, hit.layer)
      if (said !== null) lines.unshift(said)
    }
    return {
      kind: 'section',
      cellId: hit.cell,
      layer: hit.layer,
      selectionLabel: plan.selectionLabel,
      classification: classifyQuad(answer, plan, hit.piece * answer.nlay + hit.layer, stacked?.stack.fills ?? null),
      absence,
      lines,
    }
  }

  function readoutSource(): { group: string; field: Float32Array | null } | null {
    const plan = opts.plan()
    const stacked = pickedFill(plan)
    if (stacked === null) return null
    const { fill, stack } = stacked
    if (fill.kind === 'none') return { group: stack.siblings.key, field: null }
    if (fill.kind === 'contested' || fill.group === plan.drawnGroup) return null
    return { group: fill.group, field: fill.kind === 'block' || fill.kind === 'cell' ? fill.raw : null }
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
    const fill = pickedFill(plan)?.fill
    const field = fill !== undefined && (fill.kind === 'block' || fill.kind === 'cell') ? fill.field : plan.fullField
    return classLabel(field[index] ?? Number.NaN, plan.limits, plan.style, plan.scale)
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

  function legendEntries(): LegendEntry[] {
    if (answer === null || !fitted) return []
    const entries: LegendEntry[] = [{ text: camera.veText() }, { text: `plan ${layerWords(planLayer)}` }]
    // Past the VE and plan layer lines, every line pushed here says what is not drawn or why.
    const push = (...texts: string[]) => entries.push(...texts.map((text) => ({ text, keep: true })))
    if (painted !== null) {
      const { out, plan, stack } = painted
      if (plan.obsActive) push(OBS_LINE)
      else if (plan.drawsAsPoints) push(DOTS_LINE)
      else if (stack !== null) entries.push(...stackLegend(stack.siblings, stack.status))
      else if (plan.drawnGroup !== null) {
        const layers = layersSetLine(plan.drawnGroup, out.layersSet, answer.nlay)
        if (layers !== null) push(layers)
        const key = siblingKey(plan.drawnGroup)
        if (key.key === null && key.reason !== null) push(key.reason)
      }
      push(...countLines(out))
      const noLog = noLogLine(out.noLogValue)
      if (noLog !== null) push(noLog)
      if (!plan.hasIdomain) push(...plan.meshNotes.filter((note) => note.startsWith(NO_IDOMAIN_NOTE)))
    }
    push(...answer.notes)
    return entries
  }

  function legendLines(): string[] {
    return legendEntries().map((e) => e.text)
  }

  function appendLegendLines(el: HTMLElement): void {
    const entries = legendEntries()
    if (entries.length === 0) return
    el.classList.add('floating')
    for (const { text, title, keep } of entries) {
      const line = appendLine(el, text, 'label', 'section-legend-line')
      if (title !== undefined) line.title = title
      if (keep === true) line.classList.add('legend-keep')
    }
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
    readoutSource,
    selectionChanged,
    refresh,
    // Moves the band and the legend's plan layer line only; the section's colours do not depend on the plan's layer.
    planLayerChanged(layer) {
      const moved = layer !== planLayer
      planLayer = layer
      paintFrame()
      if (moved && isShown) opts.repaintLegend()
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
      siblingFields.clear()
      dropAnswer()
      frame.dispose()
      controls.dispose()
    },
  }
}
