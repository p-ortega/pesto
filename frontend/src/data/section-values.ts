// One value per section quad, read from the field the plan already holds, by the plan's own join
// rules (D-08, D-09). Only the quads in the answer are visited, so no nlay x ncells array is
// built (D-27), and every quad left uncoloured is counted for the legend.

import type { CellClass, ParIdentity } from './parmap'
import type { SectionAnswer } from './section'

export interface SectionValues {
  /** One per quad; NaN draws no fill. */
  values: Float32Array
  /** An active quad with no value from the drawn group: the quiet footprint fill (D-36). */
  noValue: Uint8Array
  /** A quad drawn as the hairline outline. */
  absence: Uint8Array
  /** Two or more rows of the drawn group on the quad's cell and layer (D-09). */
  contestedMask: Uint8Array
  /** Finite values outside the limits; they fall in the end classes (D-10). */
  beyondLimits: number
  /** Quads idomain marks inactive or pass-through that the field holds a value for (D-34). */
  inactiveWithValue: number
  /** Other absent quads the field holds a value for: no usable thickness, or outside the model with no idomain. */
  absentWithValue: number
  contested: number
  /** Quads on a cell id the plan does not hold: the plan and the section disagree about the grid. */
  unknownCell: number
  /** The zero-based layers the drawn group sets anywhere in the model, sorted. */
  layersSet: number[]
  /** Quads of a sibling group with a value that log10 cannot draw (zero or negative). */
  noLogValue: number
}

/**
 * What fills one layer of a stacked section: one sibling group's field, already in the plan's
 * scale, or the reason it has no value. `raw` is the unscaled field, kept to count what the scale lost.
 */
export type LayerFill =
  | { kind: 'block'; group: string; field: Float32Array; raw: Float32Array | null }
  | { kind: 'cell'; group: string; field: Float32Array; raw: Float32Array | null }
  | { kind: 'loading'; group: string }
  | { kind: 'failed'; group: string }
  | { kind: 'contested'; groups: string[] }
  | { kind: 'none' }

// Statuses 1 and 2 are idomain 0 and idomain -1; 3 to 5 come from the elevations.
function idomainAbsence(status: number): boolean {
  return status === 1 || status === 2
}

/** The part of the plan's held state the recolour reads; the section view's plan state is one. */
export interface SectionValuesInput {
  /** Block rows when fieldKind is 'block', one value per cell when 'cell'; already scaled. */
  fullField: Float32Array | null
  limits: [number, number]
  fieldKind: 'block' | 'cell'
  drawnGroup: string | null
  ppLayer: number | null
  joined: Array<ParIdentity | null>
  cellArray: Int32Array
  layerArray: Int32Array
  nCells: number
  drawsAsPoints: boolean
  obsActive: boolean
  hasIdomain: boolean
  referenced: Uint8Array | null
}

// The drawn group's block rows on the given cells, keyed by layer * nCells + cell, and every layer
// the group sets anywhere. The colours and the click readout both read this one map (D-23).
function blockRows(plan: SectionValuesInput, nlay: number, cells: ReadonlySet<number>): { rows: Map<number, number[]>; layers: Set<number> } {
  const found = blockRowsOf(plan, new Set(plan.drawnGroup === null ? [] : [plan.drawnGroup]), nlay, cells)
  return found.get(plan.drawnGroup ?? '') ?? { rows: new Map(), layers: new Set() }
}

// The same map for several groups in one pass over the block, for a stacked section.
function blockRowsOf(
  plan: SectionValuesInput,
  groups: ReadonlySet<string>,
  nlay: number,
  cells: ReadonlySet<number>,
): Map<string, { rows: Map<number, number[]>; layers: Set<number> }> {
  const { nCells } = plan
  const out = new Map<string, { rows: Map<number, number[]>; layers: Set<number> }>()
  for (const g of groups) out.set(g, { rows: new Map(), layers: new Set() })
  for (let i = 0; i < plan.joined.length; i++) {
    const g = plan.joined[i]?.pargp
    const held = g === undefined ? undefined : out.get(g)
    if (held === undefined) continue
    const l = plan.layerArray[i]
    const c = plan.cellArray[i]
    if (l >= 0) held.layers.add(l)
    if (!cells.has(c) || c < 0 || c >= nCells || l < 0 || l >= nlay) continue
    const key = l * nCells + c
    const list = held.rows.get(key)
    if (list) list.push(i)
    else held.rows.set(key, [i])
  }
  return out
}

function stackBlockGroups(stack: readonly LayerFill[]): Set<string> {
  const groups = new Set<string>()
  for (const fill of stack) if (fill.kind === 'block') groups.add(fill.group)
  return groups
}

/** With a stack, each layer is read from the sibling group that fills it instead of the drawn group alone. */
export function sectionValues(answer: SectionAnswer, plan: SectionValuesInput, stack: readonly LayerFill[] | null = null): SectionValues {
  const { nlay, nPieces, cell, status } = answer
  const n = nPieces * nlay
  const values = new Float32Array(n).fill(Number.NaN)
  const noValue = new Uint8Array(n)
  const absence = new Uint8Array(n)
  const contestedMask = new Uint8Array(n)
  const nCells = plan.nCells
  const useReferenced = !plan.hasIdomain && plan.referenced !== null

  let unknownCell = 0
  for (let q = 0; q < n; q++) {
    const c = cell[Math.floor(q / nlay)]
    // The plan holds nothing to say about such a cell, so it is drawn as absence and counted.
    const unknown = !(c >= 0 && c < nCells)
    if (unknown) unknownCell += 1
    const outside = useReferenced && (unknown || !plan.referenced![c])
    absence[q] = status[q] !== 0 || outside || unknown ? 1 : 0
  }

  // The value each quad would take before absence, NaN where the drawn group gives none.
  const raw = new Float32Array(n).fill(Number.NaN)
  let layersSet: number[] = []
  const field = plan.fullField
  const group = plan.drawnGroup
  const canColour = !plan.obsActive && field !== null && group !== null
  // A whole layer two siblings both fill, and a sibling value the scale could not draw.
  const layerContested = new Uint8Array(n)
  const logLost = new Uint8Array(n)

  if (canColour && stack !== null && !plan.drawsAsPoints) {
    const inAnswer = new Set<number>()
    for (let p = 0; p < nPieces; p++) inAnswer.add(cell[p])
    const blocks = blockRowsOf(plan, stackBlockGroups(stack), nlay, inAnswer)
    const filled: number[] = []
    for (let k = 0; k < nlay; k++) {
      const kind = stack[k]?.kind
      if (kind === 'block' || kind === 'cell' || kind === 'loading' || kind === 'failed') filled.push(k)
    }
    layersSet = filled
    for (let q = 0; q < n; q++) {
      const k = q % nlay
      const c = cell[Math.floor(q / nlay)]
      const fill = stack[k]
      if (fill === undefined) continue
      if (fill.kind === 'contested') {
        layerContested[q] = 1
      } else if (fill.kind === 'block') {
        if (c < 0 || c >= nCells) continue
        const rows = blocks.get(fill.group)?.rows.get(k * nCells + c)
        if (rows === undefined) continue
        if (rows.length > 1) contestedMask[q] = 1
        else {
          raw[q] = fill.field[rows[0]]
          if (fill.raw !== null && Number.isFinite(fill.raw[rows[0]]) && !Number.isFinite(raw[q])) logLost[q] = 1
        }
      } else if (fill.kind === 'cell') {
        if (c < 0 || c >= fill.field.length) continue
        raw[q] = fill.field[c]
        if (fill.raw !== null && Number.isFinite(fill.raw[c]) && !Number.isFinite(raw[q])) logLost[q] = 1
      }
    }
  } else if (canColour && plan.fieldKind === 'block') {
    const inAnswer = new Set<number>()
    for (let p = 0; p < nPieces; p++) inAnswer.add(cell[p])
    const blocks = blockRows(plan, nlay, inAnswer)
    layersSet = Array.from(blocks.layers).sort((x, y) => x - y)
    if (!plan.drawsAsPoints) {
      for (let q = 0; q < n; q++) {
        const c = cell[Math.floor(q / nlay)]
        // A cell id the plan does not hold would alias another layer's key.
        if (c < 0 || c >= nCells) continue
        const rows = blocks.rows.get((q % nlay) * nCells + c)
        if (rows === undefined) continue
        if (rows.length > 1) contestedMask[q] = 1
        else raw[q] = field[rows[0]]
      }
    }
  } else if (canColour && plan.fieldKind === 'cell' && plan.ppLayer !== null) {
    const ppLayer = plan.ppLayer
    layersSet = [ppLayer]
    if (!plan.drawsAsPoints && ppLayer >= 0 && ppLayer < nlay) {
      for (let p = 0; p < nPieces; p++) {
        const c = cell[p]
        if (c >= 0 && c < field.length) raw[p * nlay + ppLayer] = field[c]
      }
    }
  }

  const lo = Math.min(plan.limits[0], plan.limits[1])
  const hi = Math.max(plan.limits[0], plan.limits[1])
  let beyondLimits = 0
  let inactiveWithValue = 0
  let absentWithValue = 0
  let contested = 0
  let noLogValue = 0
  for (let q = 0; q < n; q++) {
    const v = raw[q]
    const valued = Number.isFinite(v)
    if (absence[q]) {
      // A contested quad holds values too, so it is counted like a single one.
      const held = valued || contestedMask[q] === 1
      contestedMask[q] = 0
      if (!held) continue
      if (idomainAbsence(status[q])) inactiveWithValue += 1
      else absentWithValue += 1
      continue
    }
    if (contestedMask[q] || layerContested[q]) {
      contestedMask[q] = 1
      contested += 1
      continue
    }
    if (!valued) {
      noValue[q] = 1
      if (logLost[q]) noLogValue += 1
      continue
    }
    values[q] = v
    if (v < lo || v > hi) beyondLimits += 1
  }

  return { values, noValue, absence, contestedMask, beyondLimits, inactiveWithValue, absentWithValue, contested, unknownCell, layersSet, noLogValue }
}

/**
 * The class a plan click would give the quad's cell on the quad's layer, by the same rules the
 * colours use (D-23): absence reads as outside the model, and null means no parameter field is
 * drawn (observations, or nothing yet), so there is nothing to classify against.
 */
export function classifyQuad(
  answer: SectionAnswer,
  plan: SectionValuesInput,
  quad: number,
  stack: readonly LayerFill[] | null = null,
): CellClass | null {
  const { nlay, nPieces, cell, status } = answer
  if (!Number.isInteger(quad) || quad < 0 || quad >= nPieces * nlay) return null
  const c = cell[Math.floor(quad / nlay)]
  const k = quad % nlay
  const nCells = plan.nCells
  if (c < 0 || c >= nCells) return { kind: 'outside-model' }
  const outside = !plan.hasIdomain && plan.referenced !== null && !plan.referenced[c]
  if (status[quad] !== 0 || outside) return { kind: 'outside-model' }
  const field = plan.fullField
  if (plan.obsActive || field === null || plan.drawnGroup === null) return null
  if (stack !== null && !plan.drawsAsPoints) {
    const fill = stack[k]
    if (fill === undefined || fill.kind === 'none') return { kind: 'no-parameter' }
    if (fill.kind === 'block') {
      const rows = blockRowsOf(plan, new Set([fill.group]), nlay, new Set([c])).get(fill.group)?.rows.get(k * nCells + c) ?? []
      if (rows.length === 0) return { kind: 'no-parameter' }
      return rows.length === 1 ? { kind: 'valued', row: rows[0] } : { kind: 'contested', rows }
    }
    if (fill.kind === 'cell') return Number.isFinite(fill.field[c]) ? { kind: 'interpolated' } : { kind: 'no-parameter' }
    return null
  }
  if (plan.fieldKind === 'block') {
    if (c < 0 || c >= nCells) return { kind: 'no-parameter' }
    const rows = blockRows(plan, nlay, new Set([c])).rows.get(k * nCells + c) ?? []
    if (rows.length === 0) return { kind: 'no-parameter' }
    if (plan.drawsAsPoints) return { kind: 'points', rows }
    return rows.length === 1 ? { kind: 'valued', row: rows[0] } : { kind: 'contested', rows }
  }
  if (plan.ppLayer === null) return null
  if (plan.drawsAsPoints || k !== plan.ppLayer || c < 0 || c >= field.length) return { kind: 'no-parameter' }
  return Number.isFinite(field[c]) ? { kind: 'interpolated' } : { kind: 'no-parameter' }
}

function joinList(items: number[]): string {
  if (items.length === 1) return String(items[0])
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}

/** Says which layers one group sets, or null when it sets every layer or none (D-09). */
export function layersSetLine(group: string, layers: number[], nlay: number): string | null {
  const distinct = Array.from(new Set(layers)).sort((x, y) => x - y)
  if (distinct.length === 0) return null
  let every = true
  for (let l = 0; l < nlay; l++) {
    if (!distinct.includes(l)) {
      every = false
      break
    }
  }
  if (every) return null
  const which = distinct.length === 1 ? `layer ${distinct[0]} only` : `layers ${joinList(distinct)}`
  return `group ${group} sets ${which}; other layers have no value from this group`
}
